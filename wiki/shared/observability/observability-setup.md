---
title: Observability Setup
description: Runbook for setting up Grafana Cloud observability and troubleshooting common issues
tags: [runbook, observability, grafana, setup]
severity: medium
related:
  - "[[shared/observability/overview]]"
  - "[[shared/observability/metrics]]"
  - "[[shared/observability/logging]]"
  - "[[shared/observability/tracing]]"
last-reviewed: 2026-11-05
---

# Observability Setup Runbook

## Overview

The deployed Workers use **Cloudflare's own observability**, Workers traces and Workers Logs, and export nothing. The **Grafana Cloud** pipeline below is for the **Bun** entries only. Frontend observability uses **Grafana Faro**.

### Runtime split — read this first

| Runtime | Services | Logging | Traces | Metrics |
|---|---|---|---|---|
| **Bun** (`src/local.ts`) | local `@osn/api`, `@pulse/api`, `@zap/api` | redacting logger, through `initObservability()` | Effect spans over OTLP to Grafana Cloud when `OTEL_EXPORTER_OTLP_ENDPOINT` is set | none exported |
| **Bun** (`src/local.ts`) | local `@cire/api` | redacting logger (`cireLoggerLayer`) | none exported; use `bunx wrangler dev` | none exported |
| **Workers** (`src/index.ts`) | deployed API Workers and the Cire invites Worker | redacting logger, a structured object per line in Workers Logs where enabled | Workers traces where enabled (local, dev, and the production Cire invites Worker); osn-api and cire-api add their Effect spans | none exported |

No metric reaches an exporter on any runtime: the factory instruments use the global `@opentelemetry/api` meter, which no service registers (englishstreetventures/osn#501).

For a deployed Worker, Cloudflare Workers Logs currently retain three days on the Free plan. Cire keeps invocation logs off because existing request paths contain the current wedding's slug. Native traces are enabled in the local Wrangler configs without URL redaction, and on every dev API Worker and the dev guest site, where only zap-api keeps query strings. Production redacts query strings and traces the Cire guest Worker; existing path slugs and outbound API URLs appear in those traces. Production API Workers keep native traces off. See [[free-tier-limits]] → Monitoring, [[tracing]] and [[logging]]. Steps 1–3 below apply to a Bun service; step 4 to every service; steps 5–6 to a Bun service exporting to Grafana.

### Grafana Cloud Free Tier Limits

- 10,000 active metric series
- 50 GB/month logs
- 50 GB/month traces
- 14-day rolling retention

## Setup Steps

### 1. Provision Grafana Cloud

1. Create a Grafana Cloud account at grafana.com
2. Note your stack URL (e.g. `https://<stack>.grafana.net`)
3. Generate an API token with OTLP write permissions
4. Note the OTLP endpoint URL (format: `https://otlp-gateway-<region>.grafana.net/otlp`)

### 2. Configure Environment Variables

Set the following environment variables in each service deployment:

```bash
# OTLP exporter configuration
# WARNING: Never commit real tokens here — use env vars, 1Password, or a secrets manager.
OTEL_EXPORTER_OTLP_ENDPOINT="https://otlp-gateway-<region>.grafana.net/otlp"
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64-encoded-instance:token>"

# Service identification
OTEL_SERVICE_NAME="<service-name>"  # e.g. "pulse-api", "osn-app"
OTEL_SERVICE_NAMESPACE="osn"
DEPLOYMENT_ENVIRONMENT="<env>"      # dev | staging | production
```

### 3. Wire Into Deploy Environment

A **Bun** service starts observability with the `@shared/observability` package:

```typescript
import { initObservability } from "@shared/observability";

const { layer: observabilityLayer } = initObservability({
  serviceName: "pulse-api",
  // Config is read from environment variables
});
```

The `initObservability()` call sets up:
- The redacting logger: pretty on `local`, a JSON line in a deployed tier
- OpenTelemetry NodeSdk exporting Effect spans — or `NoopTracingLive` when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, so an unconfigured service never spams a failing localhost exporter. Its metric reader reads Effect's own `Metric` registry, which no service uses, so it exports no factory metric
- Resource attributes (`service.name`, `service.namespace`, `service.version`, `deployment.environment`)

A **Workers** service sets no endpoint and builds no exporter. Its layer is the redacting logger merged with `WorkersTracingLive`, and its `fetch` and `scheduled` handlers call `installWorkersTracing(ctx.tracing)` first. See [osn/api/src/observability.ts](../../../osn/api/src/observability.ts) and [cire/api/src/observability.ts](../../../cire/api/src/observability.ts): each builds the layer lazily when a request first runs. Cloudflare collects traces and logs itself; nothing is flushed.

Import the workerd-safe `/config`, `/logger`, `/metrics` and `/tracing` subpaths. The package root also re-exports `makeTracingLayer`, whose `@effect/opentelemetry/NodeSdk` graph runs only on Bun; osn-api's `app.ts` imports `healthRoutes` and `observabilityPlugin` from the root, and its Worker bundle stays free of NodeSdk only because the bundler drops the unused exports. The Workers entry also passes `includeObservabilityPlugin: false`, because the per-request Elysia plugin calls `process.hrtime.bigint()`, which workerd does not provide.

### 4. Verify with Health Endpoints

`healthRoutes` exposes two endpoints, and it stays mounted on the Workers entries as well:

- **`/health`** -- liveness: 200 whenever the service is up
- **`/ready`** -- readiness: it checks a dependency only when the service passes `healthRoutes` a `probe`. None does (`osn/api`, `zap/api` and `pulse/api` pass only `serviceName`), so it answers 200 whenever `/health` does and says nothing about D1 or the coordination store. osn-api's `GET /health/coordination` is the probe that reaches its store ([[coordination-store#The health probe]]).

They confirm that the service runs. Every CI Worker deploy already asks its Worker's health by machine and rolls it back when the answer is wrong ([[production-deploy]] §7); call them by hand locally, or to look at a deployed Worker between deploys.

```bash
# local Bun services
curl http://localhost:4000/health
curl http://localhost:3001/ready

# deployed Workers. cire-api mounts no healthRoutes; its session probe answers
# {"signedIn":false} once the Worker has booted.
curl https://id.musubi.social/health
curl https://zap.cireweddings.com/health
curl https://api.cireweddings.com/api/auth/session
```

### 5. Verify Data in Grafana

Applies to Bun services with `OTEL_EXPORTER_OTLP_ENDPOINT` configured. For a Worker's logs and traces, use **Workers & Pages → osn-api / cire-api → Observability** in the Cloudflare dashboard; under `bunx wrangler dev`, the dev server's local explorer holds the same spans and logs.

1. Open Grafana Cloud explore view
2. Check **Traces** -- look for spans matching your service name
3. **Metrics** -- none arrive today (englishstreetventures/osn#501)

### 6. Build First Dashboards

Once a metric path exists (englishstreetventures/osn#501), start with the RED metrics provided by the Elysia plugin:

- **Rate** -- `http.server.request.duration` count
- **Errors** -- `http.server.request.duration` filtered by status >= 400
- **Duration** -- `http.server.request.duration` histogram

Then add domain-specific metrics:

- `osn.auth.login.attempts` by method and result
- `osn.auth.register.attempts` by step and result
- `osn.auth.rate_limited` by endpoint
- `osn.coordination.store.operations` by store and result — any `error` is osn-api's coordination store failing ([[coordination-store#Observability]])
- `pulse.events.created` / `pulse.events.status_transitions`
- `arc.token.issued` / `arc.token.verification`

## Common Issues

### Wrong OTLP Endpoint Format

**Symptom:** No data in Grafana while the service runs.

**Cause:** The OTLP endpoint must include the `/otlp` path suffix. Common mistakes:
- Missing `/otlp` suffix
- Using the Grafana UI URL instead of the OTLP gateway URL
- Using HTTP instead of HTTPS

**Fix:** Set the endpoint to `https://otlp-gateway-<region>.grafana.net/otlp`.

### Missing Auth Headers

**Symptom:** 401 errors in exporter logs.

**Cause:** The `OTEL_EXPORTER_OTLP_HEADERS` variable is unset or wrongly formatted.

**Fix:** The header must be `Authorization=Basic <base64>` where `<base64>` is `base64(<instance-id>:<api-token>)`.

```bash
echo -n "<instance-id>:<api-token>" | base64
```

### Environment Not Classified Correctly

**Symptom:** Dev and production data mixed in dashboards.

**Cause:** `DEPLOYMENT_ENVIRONMENT` is unset, or set to the wrong value.

**Fix:** Set `DEPLOYMENT_ENVIRONMENT` to exactly one of: `dev`, `staging`, `production`. This becomes the `deployment.environment` resource attribute on all telemetry.

### Debug Logs Appearing in Production

**Symptom:** Verbose debug output (e.g. step-up OTP codes in dev paths) visible in prod logs.

**Cause:** The observability layer's minimum log level is `Info` by default. An override or a misconfiguration lets `Debug` entries through.

**Fix:**
- Verify **`OSN_ENV`** is set to `"production"` in the deploy environment. `loadConfig` reads `OSN_ENV` first and falls back to `NODE_ENV`; `NODE_ENV` alone is not enough, because a bundler or platform may set it for its own reasons
- Check `OSN_LOG_LEVEL` for a debug override, and that `initObservability()` is not configured with one
- `Effect.logDebug` calls are only emitted when the minimum level is `Debug` — the default `Info` minimum suppresses them

### Traces Not Linked Across Services

**Symptom:** A call from one service to another shows as two separate traces.

**Cause:** By design. No call between services carries trace context: Cloudflare propagates none, and no service writes a `traceparent` ([[shared/observability/tracing#Trace context across services]]).

**Fix:** None needed. Match the caller's `fetch` span (its URL path, status and time) to the callee's handler span for that path at that time.

### Inbound Trace Context Trust

**Symptom:** A handler span's trace id or sampling decision seems to come from the caller.

**Cause:** Cloudflare has started honouring an inbound `traceparent`. Today a Worker's handler span starts its own trace whatever the caller sends, and [`workers-observability.e2e.ts`](../../../shared/observability/tests/wrangler/workers-observability.e2e.ts) asserts it with a forged header on every CI run.

**Fix:** Treat a linked or adopted trace id as the caller's unverified claim, never proof of who sent the request, and revisit [[shared/observability/tracing#Trace context across services]] when that test fails.

## Related

- [[free-tier-limits]] -- Workers Logs retention and what to watch in the CF dashboard
- [[shared/observability/overview]] -- observability architecture overview
- [[shared/observability/metrics]] -- metrics conventions and patterns
- [[shared/observability/logging]] -- logging rules and redaction
