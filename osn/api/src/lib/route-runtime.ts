import type { Db } from "@osn/db/service";
import type { EmailService } from "@shared/email";
import { Cause, type Effect, Exit, type Layer, ManagedRuntime, Option } from "effect";

/**
 * Services any OSN API route handler may require: the Drizzle `Db` and — for
 * the auth / account-erasure flows that send transactional mail — the
 * `EmailService`. The shared application runtime built once in `index.ts`
 * provides this superset, so a single OpenTelemetry SDK + SQLite connection
 * are reused across every request.
 */
export type AppServices = Db | EmailService;

/**
 * A long-lived runtime with the application layer graph already built.
 *
 * The whole point of threading this through the route factories is to STOP
 * rebuilding the layer graph on every request. `Effect.provide(layer)` inside
 * a per-request `Effect.runPromise` rebuilds the layer each call — which, for
 * the observability layer (`NodeSdk.layer`: BatchSpanProcessor + OTLP
 * exporters + a PeriodicExportingMetricReader) means the entire OTel SDK is
 * started and torn down per request, and for `DbLive` means a fresh
 * (never-closed) `bun:sqlite` connection per request. Building the graph once
 * into a `ManagedRuntime` collapses that to a one-time boot cost.
 */
export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>;

/**
 * What a defect — as opposed to a typed failure — is rejected as by
 * {@link makeAppRunner}'s `run` (S-M17).
 *
 * The point of this class is what it deliberately does NOT carry: a `_tag`.
 * `Data.TaggedError` is the repo's whole error vocabulary and it produces real
 * `Error` subclasses carrying a `_tag` string, so "is an `Error` with an
 * allow-listed `_tag`" cannot on its own distinguish a failure a service chose
 * to expose from an internal invariant that blew up. `Effect.die`,
 * `Effect.orDie` (an established pattern here — see `routes/graph.ts`,
 * `routes/recommendations.ts`, `routes/organisation.ts`) and a bare `throw`
 * inside `Effect.sync` all turn such an error into a DEFECT, and under Effect
 * v4 `Cause.squash` — what `ManagedRuntime.runPromise` rejects with — hands
 * that defect object straight back to the caller. (v3's `FiberFailure` +
 * `Cause.failureOption` collapsed it to `None` instead, which is why the
 * message-extraction helpers were written assuming a defect could never carry
 * a tag.)
 *
 * Wrapping it here is the structural fix: nothing downstream can read a tag
 * off a defect, because there is no longer a tag on the value it sees. The
 * full {@link Cause} is retained as the native `Error.cause` (and read back
 * typed via `effectCause`) so server-side diagnosis keeps every detail; only
 * the message is flattened, and to a constant.
 */
export class OpaqueDefect extends Error {
  override readonly name = "OpaqueDefect";

  constructor(cause: Cause.Cause<unknown>) {
    super("Request failed", { cause });
  }

  /**
   * The retained `Cause`, typed — the native `Error.cause` is `unknown`.
   *
   * A getter on the prototype rather than an own field, deliberately: the
   * `Error(message, { cause })` constructor defines `cause` NON-enumerable, so
   * with nothing enumerable added on top, `JSON.stringify` / `Object.values` /
   * a structured logger serialising this error yields `{"name":"OpaqueDefect"}`
   * and nothing of the cause. Reading the cause has to be deliberate, which is
   * the point of the wrapper.
   */
  get effectCause(): Cause.Cause<unknown> {
    return this.cause as Cause.Cause<unknown>;
  }
}

/**
 * What a route factory gets back from {@link makeAppRunner}: the runtime it
 * should keep (shared or freshly wrapped) and the per-request `run` helper
 * bound to it.
 */
export type AppRunner<R extends AppServices> = {
  runtime: ManagedRuntime.ManagedRuntime<R, never>;
  run: <A, E>(eff: Effect.Effect<A, E, R>) => Promise<A>;
};

/**
 * Run one effect the way every route handler does: succeed with its value,
 * reject with the typed failure, and reject with an {@link OpaqueDefect} for
 * anything else.
 *
 * Upstream's own v4 migration note for `Runtime.isFiberFailure` is "use an
 * Exit-returning runner and inspect Exit or Cause" — that is exactly this.
 * `runPromiseExit` never squashes, so the `Fail`/defect distinction the
 * `Cause` carries survives to the one place that has to act on it, instead of
 * being flattened into a thrown value that the message helpers then have to
 * guess about.
 *
 * `Cause.findErrorOption` returns the first `Fail` error, which is precisely
 * the typed `E` channel a route's `catch` is entitled to read. `None` means
 * the request died or was interrupted: no typed failure exists, so nothing
 * about it is fit to describe to a client.
 */
function runThroughExit<A, E, R>(
  runtime: ManagedRuntime.ManagedRuntime<R, never>,
  eff: Effect.Effect<A, E, R>,
): Promise<A> {
  return runtime.runPromiseExit(eff).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const failure = Cause.findErrorOption(exit.cause);
    if (Option.isSome(failure)) throw failure.value;
    throw new OpaqueDefect(exit.cause);
  });
}

/**
 * Build the per-request `run` helper a route factory uses to execute service
 * effects.
 *
 * - Production (`index.ts`) passes one shared {@link AppRuntime}; every route
 *   group reuses the same observability SDK + DB connection.
 * - Tests pass only a `Layer`; it is wrapped in a `ManagedRuntime` ONCE here,
 *   at factory-construction time, so the test layer is built a single time per
 *   route group rather than on every request.
 *
 * Either way, the expensive per-request `Effect.provide(layer)` rebuild is
 * gone, and either way the single {@link runThroughExit} path applies — the
 * injected and fallback branches differ only in which runtime they hand it, so
 * a test can never observe error handling the production routes don't have.
 *
 * Generic over the services `R` the fallback layer provides (`Db`, or
 * `Db | EmailService` for the auth / erasure routes). The shared
 * {@link AppRuntime} provides the full {@link AppServices} superset and is
 * assignable to a `ManagedRuntime<R>` for any subset `R` (the runtime's
 * requirement channel is contravariant), so the one process-wide runtime
 * satisfies every route group.
 */
export function makeAppRunner<R extends AppServices>(
  injectedRuntime: AppRuntime | undefined,
  fallbackLayer: Layer.Layer<R, never, never>,
): AppRunner<R> {
  const runtime = injectedRuntime ?? ManagedRuntime.make(fallbackLayer);
  return { runtime, run: (eff) => runThroughExit(runtime, eff) };
}
