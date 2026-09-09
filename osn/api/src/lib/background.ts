import { AsyncLocalStorage } from "node:async_hooks";

import { Context, Effect } from "effect";

/**
 * Where a request's background work is collected so the Worker entry can hand
 * it to `ExecutionContext.waitUntil`.
 *
 * The problem this exists for: on workerd, once the `Response` is returned and
 * no `waitUntil` promise is pending, the request context is torn down. A task
 * queued on a macrotask that then opens an outbound subrequest — which is
 * exactly what `Effect.forkDetach` of an email send is — has no guarantee of
 * running. It is neither awaited nor cancelled; it is orphaned. On the Bun dev
 * server the same fibre completes, so this diverges only on the deployed
 * Worker and no unit test, local run or `wrangler deploy --dry-run` observes
 * it.
 *
 * The entry's own rule, at `index.ts`, is "no fiber survives between requests
 * on workerd". That is why the telemetry drain was moved into `waitUntil`; it
 * applies just as much to a security notice or a recovery code.
 */
export interface BackgroundSink {
  readonly add: (work: Promise<unknown>) => void;
}

/**
 * Drop on the floor — which is precisely today's behaviour anywhere there is
 * no `ExecutionContext`: the Bun dev server, unit tests, and any two-argument
 * caller of the Worker handler. Making that the default is what lets
 * {@link withBackgroundSink} degrade instead of throwing.
 */
const NOOP_SINK: BackgroundSink = { add: () => {} };

/**
 * The sink, carried through Effect's own context rather than read from
 * `AsyncLocalStorage` inside a fiber.
 *
 * A `Context.Reference` rather than a `Context.Service` on purpose: a
 * `Reference<S>` is a `Service<never, S>`, so its identifier is `never` and
 * reading it contributes **nothing** to an effect's `R` channel. A plain
 * service would put `BackgroundSink` into the requirements of all seven
 * notification sites and every test layer that provides them — a wide blast
 * radius for what is plumbing.
 *
 * Reading `AsyncLocalStorage` from inside the fiber would be the obvious
 * alternative and is wrong: Effect v4's scheduler batches fiber continuations
 * into one drain, so a continuation can run under whichever ALS context
 * scheduled the batch. ALS is therefore read exactly once, synchronously, at
 * the `run` boundary — see `route-runtime.ts`.
 */
export const CurrentBackgroundSink = Context.Reference<BackgroundSink>("osn/api/BackgroundSink", {
  defaultValue: () => NOOP_SINK,
});

const storage = new AsyncLocalStorage<BackgroundSink>();

/**
 * The boundary read. Entry-side only — never call this from inside a fiber,
 * for the batching reason above.
 */
export function currentBackgroundSink(): BackgroundSink | undefined {
  return storage.getStore();
}

/** The one method of `ExecutionContext` this module needs. */
export interface WaitUntilCtx {
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Run `fn` with a fresh per-request sink, then hand everything it collected to
 * `waitUntil`.
 *
 * Per-request, not module-global: several requests are in flight in one
 * isolate, so a single mutable "current waitUntil" would attribute one
 * request's background work to another's context.
 *
 * With no `ctx` this returns `fn()` untouched — no ALS frame, no sink, the
 * default no-op reference — so behaviour off-Workers is byte-identical to
 * before this existed.
 */
export async function withBackgroundSink<T>(
  ctx: WaitUntilCtx | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!ctx) return fn();

  const pending: Promise<unknown>[] = [];
  const sink: BackgroundSink = {
    add: (work) => {
      pending.push(work);
    },
  };

  const result = await storage.run(sink, fn);
  for (const work of pending) ctx.waitUntil(work);
  return result;
}

/**
 * Fork `eff` detached AND register its completion with the request's sink, so
 * the isolate stays alive for it on workerd.
 *
 * Replaces a bare `Effect.forkDetach` at every site that starts outbound work
 * the user does not wait for. The observer fires on **any** exit — success,
 * typed failure, defect or interrupt — so a send that fails still settles its
 * promise and can never wedge `waitUntil`.
 */
export function forkBackground<A, E, R>(
  eff: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, R> {
  return Effect.gen(function* () {
    const sink = yield* CurrentBackgroundSink;
    const fiber = yield* Effect.forkDetach(eff);
    sink.add(
      new Promise<void>((resolve) => {
        fiber.addObserver(() => resolve());
      }),
    );
  });
}
