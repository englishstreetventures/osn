import type { Db } from "@osn/db/service";
import type { EmailService } from "@shared/email";
import { type Effect, type Layer, ManagedRuntime } from "effect";

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
 * gone.
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
): {
  runtime: ManagedRuntime.ManagedRuntime<R, never>;
  run: <A, E>(eff: Effect.Effect<A, E, R>) => Promise<A>;
} {
  const runtime = injectedRuntime ?? ManagedRuntime.make(fallbackLayer);
  return { runtime, run: (eff) => runtime.runPromise(eff) };
}
