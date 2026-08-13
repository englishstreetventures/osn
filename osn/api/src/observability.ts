import { loadConfig } from "@shared/observability/config";
import { makeLoggerLayer } from "@shared/observability/logger";
import { Effect, Layer } from "effect";

/**
 * Redacting structured-logger layer for osn/api — the workerd-safe sibling of
 * the full `initObservability()` layer used on the Bun path (`local.ts`).
 *
 * Replaces Effect's default logger with the shared OSN redacting logger (json
 * in prod / pretty in dev) so every `Effect.log*` message + annotation is run
 * through the secret/PII deny-list (`@shared/observability/logger`'s `redact`)
 * before serialization. Without this layer osn's log calls fall through to
 * Effect's *default* logger and annotated PII — `email`, `token`, `sessionId`,
 * `passwordHash`, … — is NOT scrubbed.
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
 * `@opentelemetry/*` SDK, no `@effect/opentelemetry/NodeSdk`), so adopting this
 * does not drag the Node OTel SDK into the Worker bundle. This is what the
 * eventual Phase-6 Workers entry will hand to `createApp` as its
 * `observabilityLayer`; the Bun entry keeps providing the FULL logger + OTLP
 * tracing layer via `initObservability()`. Metric/trace EXPORT on workerd
 * remains deferred — the recording call-sites are correct and type-checked
 * today, but are no-ops until an exporter is attached.
 *
 * Typed as `Layer.Layer<never>` (the return type of `makeLoggerLayer`) so it is
 * interchangeable with the full observability layer in the app runtime / every
 * route-factory signature — no signature changes required.
 */
let builtLayer: Layer.Layer<never> | undefined;

export const osnLoggerLayer: Layer.Layer<never> = Layer.suspend(
  () => (builtLayer ??= makeLoggerLayer(loadConfig({ serviceName: "osn-api" }))),
);

/**
 * Run a fully-resolved osn effect to a Promise with the redacting logger
 * installed. The effect must already have its services (`DbService`,
 * `EmailService`, …) provided and its typed errors handled — this only swaps in
 * the logger. Use on the Workers path instead of bare `Effect.runPromise` so no
 * log line escapes redaction.
 */
export const runOsn = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, osnLoggerLayer));

/**
 * Synchronous counterpart for framework error boundaries and startup banners,
 * where there is no Promise to await.
 */
export const runOsnSync = <A, E>(effect: Effect.Effect<A, E, never>): A =>
  Effect.runSync(Effect.provide(effect, osnLoggerLayer));
