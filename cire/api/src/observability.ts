import { loadConfig } from "@shared/observability/config";
import { makeLoggerLayer } from "@shared/observability/logger";
import { WorkersTracingLive } from "@shared/observability/tracing";
import { Layer, ManagedRuntime, type Effect } from "effect";

/**
 * Redacting logger + Workers trace mirror for cire/api.
 *
 * ## Logging
 *
 * Replaces Effect's default logger with the shared OSN redacting logger (a
 * structured object to Workers Logs on workerd, pretty on `local`) so every
 * `Effect.log*` message + annotation is run through the secret/PII deny-list
 * (`@shared/observability/logger`'s `redact`) before it reaches the console.
 * Without this layer cire's log calls fall through to Effect's *default* logger
 * and guest PII annotated onto a line — `firstName`, `dietary`, `publicId`,
 * `cire_session`, `osnAccountId`, … — is NOT scrubbed. The deny-list already
 * enumerates every cire field (see `redact.ts`); this layer is what applies it.
 *
 * ## Tracing
 *
 * `WorkersTracingLive` mirrors each `Effect.withSpan` into the Worker's
 * Cloudflare trace as a custom span, once the handler has installed its
 * `ctx.tracing` (`index.ts`, top of `fetch` and `scheduled`). Cloudflare
 * records the handler, D1, R2 and outbound `fetch` spans itself; nothing here
 * exports anything, and nothing needs flushing. With no tracing installed (the
 * Bun dev server, tests) the mirror is Effect's default in-process tracer.
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
 */
let builtLayer: Layer.Layer<never> | undefined;

export const cireLoggerLayer: Layer.Layer<never> = Layer.suspend(() => {
  builtLayer ??= Layer.merge(
    makeLoggerLayer(loadConfig({ serviceName: "cire-api" })),
    WorkersTracingLive,
  );
  return builtLayer;
});

/**
 * Module-scope runtime for `cireLoggerLayer`, built once per isolate instead
 * of once per `runCire`/`runCireSync` call — each call would otherwise pay for a
 * fresh `FiberRuntime` plus `Layer.buildWithScope`, twice over on routes that
 * call either helper more than once.
 *
 * This is safe with the `Layer.suspend` above left intact: `ManagedRuntime.make`
 * only runs `scopeMake` at construction (pure, no env access) — it does not
 * force the layer. The layer itself still builds lazily, on the first
 * `runPromise`/`runSync` below, so `loadConfig` still never runs during module
 * evaluation. Do NOT "simplify" this by inlining `loadConfig` or dropping
 * `Layer.suspend`: on workerd, `nodejs_compat_populate_process_env` only fills
 * `process.env` on first access, and a config read during module load would
 * silently pin every deployed tier to `local` (pretty logs, debug level) with
 * no error at all.
 */
const cireRuntime = ManagedRuntime.make(cireLoggerLayer);

/**
 * Run a fully-resolved cire effect to a Promise with the redacting logger
 * installed. The effect must already have its services (`DbService`,
 * `R2Service`, `AssetsR2Service`, …) provided and its typed errors handled —
 * this only swaps in the logger. Use everywhere instead of bare
 * `Effect.runPromise` so no log line escapes redaction.
 */
export const runCire = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  cireRuntime.runPromise(effect);

/**
 * Synchronous counterpart for the framework error boundary (`app.ts` onError)
 * and the local dev-server banners, where there is no Promise to await.
 */
export const runCireSync = <A, E>(effect: Effect.Effect<A, E, never>): A =>
  cireRuntime.runSync(effect);
