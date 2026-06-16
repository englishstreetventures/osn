import { loadConfig } from "@shared/observability/config";
import { makeLoggerLayer } from "@shared/observability/logger";
import { Effect } from "effect";

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
 * Built once at module load from env (`OSN_ENV` / `OSN_LOG_LEVEL`, parsed by
 * `loadConfig`). On workerd `nodejs_compat` populates `process.env` from
 * wrangler `[vars]` + secrets; in bun:sqlite tests and the local dev server
 * `process.env` is native.
 *
 * Workerd-safe: the `/logger` and `/config` subpaths import only `effect` (no
 * `@opentelemetry/*` SDK), so adopting this does not drag the Node OTel SDK
 * into the Worker bundle. Metric/trace EXPORT on workerd remains deferred —
 * see `wiki/todo/deferred.md`; the spans + counters defined elsewhere are
 * no-ops until an exporter is attached, but the recording call-sites are
 * correct and type-checked today.
 */
export const cireLoggerLayer = makeLoggerLayer(loadConfig({ serviceName: "cire-api" }));

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
