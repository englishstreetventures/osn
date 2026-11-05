/**
 * Tracing surface that is safe to import from a Cloudflare Worker.
 *
 * **Do not re-export `./layer` from here.** `makeTracingLayer` builds the
 * `@effect/opentelemetry` `NodeSdk` layer and its import graph pulls
 * `@opentelemetry/sdk-*` plus Node built-ins, none of which run on workerd. The
 * Workers import this barrel for `WorkersTracingLive`, so anything reachable
 * from here lands in their bundles. `makeTracingLayer` is still exported from
 * the package root (`@shared/observability`), which is Bun-only by
 * construction, and `tests/tracing/workerd-safety.test.ts` fails if this
 * barrel's import graph regains a Node-only dependency.
 */
export { NoopTracingLive } from "./noop";
export {
  installWorkersTracing,
  WorkersTracingLive,
  type WorkersSpan,
  type WorkersTracing,
} from "./workers";
