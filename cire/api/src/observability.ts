import { loadConfig } from "@shared/observability/config";
import { makeLoggerLayer } from "@shared/observability/logger";
import { Effect, Layer } from "effect";

/**
 * Redacting structured-logger layer for cire/api.
 *
 * Replaces Effect's default logger with the shared OSN redacting logger (json
 * in prod / pretty in dev) so every `Effect.log*` message + annotation is run
 * through the secret/PII deny-list (`@shared/observability/logger`'s `redact`)
 * before serialization. Without this layer cire's log calls fall through to
 * Effect's *default* logger and guest PII annotated onto a line — `firstName`,
 * `dietary`, `publicId`, `cire_session`, `osnAccountId`, … — is NOT scrubbed.
 * The deny-list already enumerates every cire field (see `redact.ts`); this
 * layer is what finally applies it.
 *
 * Configured from env (`OSN_ENV` / `OSN_LOG_LEVEL`, parsed by `loadConfig`),
 * but built LAZILY — `Layer.suspend` defers `loadConfig` to the first time the
 * layer is actually provided to an effect, which is always inside a request or
 * cron handler. On workerd this is load-bearing: `nodejs_compat_populate_process_env`
 * fills `process.env` from wrangler `[vars]` + secrets on first access, and
 * during module evaluation there is nothing to read yet — a config parsed at
 * module load would see an empty `process.env` and pin every deployed tier to
 * `local` (pretty logs, debug level). In bun:sqlite tests and the local dev
 * server `process.env` is native and the timing makes no difference. The result
 * is memoised, so the config is parsed once per isolate, not once per request.
 *
 * Workerd-safe: the `/logger` and `/config` subpaths import only `effect` (no
 * `@opentelemetry/*` SDK), so adopting this does not drag the Node OTel SDK
 * into the Worker bundle. Metric/trace EXPORT on workerd remains deferred —
 * see `wiki/todo/deferred.md`; the spans + counters defined elsewhere are
 * no-ops until an exporter is attached, but the recording call-sites are
 * correct and type-checked today.
 */
let builtLayer: Layer.Layer<never> | undefined;

export const cireLoggerLayer: Layer.Layer<never> = Layer.suspend(
  () => (builtLayer ??= makeLoggerLayer(loadConfig({ serviceName: "cire-api" }))),
);

/**
 * Run a fully-resolved cire effect to a Promise with the redacting logger
 * installed. The effect must already have its services (`DbService`,
 * `R2Service`, `AssetsR2Service`, …) provided and its typed errors handled —
 * this only swaps in the logger. Use everywhere instead of bare
 * `Effect.runPromise` so no log line escapes redaction.
 */
export const runCire = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, cireLoggerLayer));

/**
 * Synchronous counterpart for the framework error boundary (`app.ts` onError)
 * and the local dev-server banners, where there is no Promise to await.
 */
export const runCireSync = <A, E>(effect: Effect.Effect<A, E, never>): A =>
  Effect.runSync(Effect.provide(effect, cireLoggerLayer));
