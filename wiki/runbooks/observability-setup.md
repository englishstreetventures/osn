---
title: Observability Setup
description: Runbook for setting up Grafana Cloud observability and troubleshooting common issues
tags: [runbook, observability, grafana, setup]
severity: medium
related:
  - "[[observability/overview]]"
  - "[[observability/metrics]]"
  - "[[observability/logging]]"
  - "[[observability/tracing]]"
last-reviewed: 2026-07-23
---

# Observability Setup Runbook

## Overview

OSN uses **OpenTelemetry end-to-end**, shipped to **Grafana Cloud** (free tier). Frontend observability uses **Grafana Faro** (same OTLP endpoint, no Sentry).

### Runtime split — read this first

The OTLP pipeline described below runs on the **Bun** entries only. `@osn/api` and `@cire/api` are deployed as **Cloudflare Workers**, and workerd cannot host the Node OTel SDK:

| Runtime | Services | Logging | Traces + metrics |
|---|---|---|---|
| **Bun** (`src/local.ts`) | local `@osn/api`, `@pulse/api`, `@zap/api` | redacting logger, through `initObservability()` | full OTLP export to Grafana Cloud |
| **Workers** (`src/index.ts`) | deployed `@osn/api` (`id.cireweddings.com`), `@cire/api` (`api.cireweddings.com`) | redacting logger only — `osnLoggerLayer` / `cireLoggerLayer`, built from the `@shared/observability/logger` + `/config` subpaths so no `@opentelemetry/*` module enters the bundle | **export deferred** — the recording call sites are typed and correct but are no-ops until an exporter is attached |

So for a deployed Worker, telemetry means **Cloudflare Workers Logs** (`[observability]` in each `wrangler.toml`, 7-day retention) plus the resource Metrics tabs, not Grafana. See [[free-tier-limits]] → Monitoring. Steps 1–3 below apply to a Bun service; steps 4–6 apply to whichever surface actually exports.

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
- JSON logger with redaction (prod) or pretty logger (dev)
- OpenTelemetry NodeSdk with trace + metric exporters — or `NoopTracingLive` when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, so an unconfigured service never spams a failing localhost exporter
- Resource attributes (`service.name`, `service.namespace`, `service.version`, `deployment.environment`)

A **Workers** service builds the logger layer alone, because the NodeSdk cannot load on workerd:

```typescript
// osn/api/src/observability.ts (cire/api/src/observability.ts is the twin)
import { loadConfig } from "@shared/observability/config";
import { makeLoggerLayer } from "@shared/observability/logger";

export const osnLoggerLayer = makeLoggerLayer(loadConfig({ serviceName: "osn-api" }));
```

Import the `/config` and `/logger` subpaths, never the package root — the root barrel pulls in `@effect/opentelemetry/NodeSdk` and the bundle then fails to load. The Workers entry also passes `includeObservabilityPlugin: false`, because the per-request Elysia plugin calls `process.hrtime.bigint()`, which workerd does not provide.

### 4. Verify with Health Endpoints

`healthRoutes` exposes two endpoints, and it stays mounted on the Workers entries as well:

- **`/health`** -- basic liveness check
- **`/ready`** -- readiness check (includes dependency health)

Call these endpoints after each deployment. They confirm that the service runs and that its dependencies answer.

```bash
# local Bun services
curl http://localhost:4000/health
curl http://localhost:3001/ready

# deployed Workers
curl https://id.cireweddings.com/health
curl https://api.cireweddings.com/health
```

### 5. Verify Data in Grafana

Applies to the exporting (Bun) services. For a deployed Worker, read the logs in the CF dashboard instead: **Workers & Pages → osn-api / cire-api → Observability**.

1. Open Grafana Cloud explore view
2. Check **Logs** -- look for structured JSON log entries from your service
3. Check **Traces** -- look for spans matching your service name
4. Check **Metrics** -- look for `http.server.*` metrics from the Elysia plugin

### 6. Build First Dashboards

Start with the RED metrics provided by the Elysia plugin:

- **Rate** -- `http.server.request.duration` count
- **Errors** -- `http.server.request.duration` filtered by status >= 400
- **Duration** -- `http.server.request.duration` histogram

Then add domain-specific metrics:

- `osn.auth.login.attempts` by method and result
- `osn.auth.register.attempts` by step and result
- `osn.auth.rate_limited` by endpoint
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

### Environment Not Classified Correctly (S-L20)

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

**Symptom:** Each service shows its own root spans but no parent-child relationship across services.

**Cause:** Outbound HTTP calls do not use `instrumentedFetch` from `@shared/observability/fetch`, so nothing injects the `traceparent` header.

**Fix:** Never use raw `fetch()` for S2S calls. Route every service-to-service HTTP call through `instrumentedFetch`.

### Inbound Trace Context Trust

**Symptom:** External requests show up with attacker-controlled trace IDs in internal traces.

**Cause:** An inbound `traceparent` is trustworthy only from an ARC-authenticated caller (S-H13).

**Fix:** The Elysia plugin only extracts upstream trace context when the request presents `Authorization: ARC ...`. Anonymous/public requests start fresh root spans. The Workers entries run without that plugin, so they neither extract nor emit trace context at all.

## Related

- [[free-tier-limits]] -- Workers Logs retention and what to watch in the CF dashboard
- [[observability/overview]] -- observability architecture overview
- [[observability/metrics]] -- metrics conventions and patterns
- [[observability/logging]] -- logging rules and redaction
