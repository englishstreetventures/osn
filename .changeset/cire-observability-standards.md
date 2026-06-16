---
"@cire/api": minor
---

Bring cire/api up to the OSN observability standard for logs, traces, and
metrics — adapted to its Cloudflare Workers (workerd) runtime.

- **Redacting logger**: adopt `@shared/observability/logger` via a new
  `cireLoggerLayer` + `runCire` / `runCireSync` helpers (`src/observability.ts`),
  provided at every Effect run. Guest PII annotated onto a log line
  (`firstName`, `dietary`, `publicId`/claim code, `cire_session`,
  `osnAccountId`, …) is now scrubbed by the shared deny-list — previously cire
  used Effect's default, non-redacting logger.
- **No `console.*`**: the two local dev-server banners now use
  `Effect.logInfo`.
- **Traces**: `Effect.withSpan("cire.<domain>.<op>")` added to the claim,
  rsvp, session, import, revert, and weddings services (invite + account-link
  already had spans; account-link span names renamed under the `cire.`
  namespace). The one outbound S2S call (osn-bridge → osn-api) now goes through
  `instrumentedFetch`, propagating a W3C `traceparent`.
- **Metrics**: new `src/metrics.ts` — typed counters/histograms under the
  `cire.*` namespace with bounded string-literal attribute unions (claim,
  session, rsvp, import apply/revert/parse-rejection, invite save/upload, and
  account-link request/unlink/resolve-duration).

Workerd-safe: only the `effect`- and `@opentelemetry/api`-only subpaths are
imported, so the Worker bundle still builds (verified via `wrangler` dry-run).
Metric/trace **export** on workerd remains deferred — the spans and counters
are no-ops until an exporter (otel-cf-workers / Analytics Engine) is wired, but
the recording call-sites are correct and type-checked today.
