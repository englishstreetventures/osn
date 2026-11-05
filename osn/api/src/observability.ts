import { loadConfig } from "@shared/observability/config";
import { makeLoggerLayer } from "@shared/observability/logger";
import { WorkersTracingLive } from "@shared/observability/tracing";
import { Layer, ManagedRuntime, type Effect } from "effect";

/**
 * Redacting logger + Workers trace mirror for osn/api — the workerd-safe
 * sibling of the full `initObservability()` layer used on the Bun path
 * (`local.ts`).
 *
 * ## Logging
 *
 * Replaces Effect's default logger with the shared OSN redacting logger (a
 * structured object to Workers Logs on workerd, pretty on `local`) so every
 * `Effect.log*` message + annotation is run through the secret/PII deny-list
 * (`@shared/observability/logger`'s `redact`) before it reaches the console.
 * Without this layer osn's log calls fall through to Effect's *default* logger
 * and annotated PII — `email`, `token`, `sessionId`, `passwordHash`, … — is NOT
 * scrubbed.
 *
 * ## Tracing
 *
 * `WorkersTracingLive` mirrors each `Effect.withSpan` into the Worker's
 * Cloudflare trace as a custom span, once the handler has installed its
 * `ctx.tracing` (`index.ts`, top of `fetch` and `scheduled`). Cloudflare
 * records the handler, D1 and outbound `fetch` spans itself; nothing here
 * exports anything, and nothing needs flushing. With no tracing installed
 * (Bun tests) the mirror is Effect's default in-process tracer.
 *
 * This layer is what `index.ts` hands `buildAppDeps` as its
 * `observabilityLayer`, and `build-deps.ts` merges it into the shared
 * `appRuntime` every route factory runs on; every cron sweep in `index.ts`
 * provides it too.
 *
 * ## Why this is built lazily
 *
 * Configured from env (`OSN_ENV` / `OSN_LOG_LEVEL`, parsed by `loadConfig`), but
 * built LAZILY — `Layer.suspend` defers `loadConfig` to the first time the layer
 * is actually provided to an effect, which is always inside a request or cron
 * handler. On workerd this is load-bearing: `nodejs_compat_populate_process_env`
 * fills `process.env` from wrangler `[vars]` + secrets on first access, and
 * during module evaluation there is nothing to read yet — a config parsed at
 * module load would see an empty `process.env` and pin every deployed tier to
 * `local` (pretty logs, debug level). In bun:sqlite tests and the local dev
 * server `process.env` is native and the timing makes no difference. The result
 * is memoised, so the config is parsed once per isolate, not once per request.
 *
 * Workerd-safe: the `/logger`, `/config` and `/tracing` subpaths import only
 * `effect` plus the dependency-free `@opentelemetry/api` façade (already in the
 * bundle via `@shared/observability/metrics`) — no `NodeSdk`, no Node built-ins.
 * `shared/observability/tests/tracing/workerd-safety.test.ts` walks the static
 * import graph of each of those subpaths and fails if that stops being true.
 *
 * Metric export has no workerd path: `@shared/observability` builds its
 * instruments from the raw `@opentelemetry/api` meter, which nothing registers
 * here, so the counters are correct, type-checked no-ops on workerd.
 *
 * Typed as `Layer.Layer<never>` so it stays interchangeable with the full
 * observability layer in the app runtime / every route-factory signature.
 * (`Tracer.Tracer` is a context *reference*, which always has a default and so
 * is erased from a layer's output type.)
 *
 * The name says "logger" though the layer carries the tracer as well; it is
 * threaded through many files, so renaming it is a separate mechanical patch.
 */
let builtLayer: Layer.Layer<never> | undefined;

export const osnLoggerLayer: Layer.Layer<never> = Layer.suspend(() => {
  builtLayer ??= Layer.merge(
    makeLoggerLayer(loadConfig({ serviceName: "osn-api" })),
    WorkersTracingLive,
  );
  return builtLayer;
});

/**
 * Shared runtime for `osnLoggerLayer`, built once rather than per call. Do not
 * replace it with a per-call `Effect.provide`, which builds and tears down the
 * layer around every run.
 *
 * `Layer.suspend` keeps `loadConfig` lazy: constructing this runtime does not
 * read environment configuration.
 */
const osnRuntime = ManagedRuntime.make(osnLoggerLayer);

/**
 * Run a fully-resolved osn effect to a Promise with the redacting logger
 * installed. The effect must already have its services (`DbService`,
 * `EmailService`, …) provided and its typed errors handled — this only swaps in
 * the logger. Use on the Workers path instead of bare `Effect.runPromise` so no
 * log line escapes redaction.
 */
export const runOsn = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  osnRuntime.runPromise(effect);

/**
 * Synchronous counterpart for framework error boundaries and startup banners,
 * where there is no Promise to await.
 */
export const runOsnSync = <A, E>(effect: Effect.Effect<A, E, never>): A =>
  osnRuntime.runSync(effect);
