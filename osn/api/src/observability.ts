import { loadConfig } from "@shared/observability/config";
import { makeLoggerLayer } from "@shared/observability/logger";
import { Effect } from "effect";

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
 * Built once at module load from env (`OSN_ENV` / `OSN_LOG_LEVEL`, parsed by
 * `loadConfig`). On workerd `nodejs_compat` populates `process.env` from
 * wrangler `[vars]` + secrets; in bun:sqlite tests and the local dev server
 * `process.env` is native.
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
export const osnLoggerLayer = makeLoggerLayer(loadConfig({ serviceName: "osn-api" }));

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
