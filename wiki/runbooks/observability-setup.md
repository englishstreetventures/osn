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
last-reviewed: 2026-04-23
---

# Observability Setup Runbook

## Overview

OSN uses **OpenTelemetry end-to-end**, shipped to **Grafana Cloud** (free tier). Frontend observability uses **Grafana Faro** (same OTLP endpoint, no Sentry).

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

Each service initializes observability via the `@shared/observability` package:

```typescript
import { initObservability } from "@shared/observability";

const observabilityLayer = initObservability({
  serviceName: "pulse-api",
  // Config is read from environment variables
});
```

The `initObservability()` call sets up:
- JSON logger with redaction (prod) or pretty logger (dev)
- OpenTelemetry NodeSdk with trace + metric exporters
- Resource attributes (`service.name`, `service.namespace`, `service.version`, `deployment.environment`)

### 4. Verify with Health Endpoints

The Elysia observability plugin exposes two endpoints:

- **`/health`** -- basic liveness check
- **`/ready`** -- readiness check (includes dependency health)

Hit these endpoints after deployment to verify the service is running and the observability pipeline is connected.

```bash
curl http://localhost:4000/health
curl http://localhost:3001/ready
```

### 5. Verify Data in Grafana

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

**Symptom:** No data appearing in Grafana despite service running.

**Cause:** The OTLP endpoint must include the `/otlp` path suffix. Common mistakes:
- Missing `/otlp` suffix
- Using the Grafana UI URL instead of the OTLP gateway URL
- Using HTTP instead of HTTPS

**Fix:** Ensure the endpoint is `https://otlp-gateway-<region>.grafana.net/otlp`.

### Missing Auth Headers

**Symptom:** 401 errors in exporter logs.

**Cause:** The `OTEL_EXPORTER_OTLP_HEADERS` variable is not set or incorrectly formatted.

**Fix:** The header must be `Authorization=Basic <base64>` where `<base64>` is `base64(<instance-id>:<api-token>)`.

```bash
echo -n "<instance-id>:<api-token>" | base64
```

### Environment Not Classified Correctly (S-L20)

**Symptom:** Dev and production data mixed in dashboards.

**Cause:** `DEPLOYMENT_ENVIRONMENT` not set or set to wrong value.

**Fix:** Set `DEPLOYMENT_ENVIRONMENT` to exactly one of: `dev`, `staging`, `production`. This becomes the `deployment.environment` resource attribute on all telemetry.

### Debug Logs Appearing in Production

**Symptom:** Verbose debug output (e.g. step-up OTP codes in dev paths) visible in prod logs.

**Cause:** The observability layer's minimum log level is `Info` by default, but if overridden or misconfigured, `Debug` entries can leak.

**Fix:**
- Verify `NODE_ENV` is set to `"production"` in the deploy environment
- Check that `initObservability()` is not configured with a debug override
- `Effect.logDebug` calls are only emitted when the minimum level is `Debug` — the default `Info` minimum suppresses them

### Traces Not Linked Across Services

**Symptom:** Each service shows its own root spans but no parent-child relationship across services.

**Cause:** Outbound HTTP calls not using `instrumentedFetch` from `@shared/observability/fetch`, so `traceparent` header is not injected.

**Fix:** All service-to-service HTTP calls must go through `instrumentedFetch`. Never use raw `fetch()` for S2S calls.

### Inbound Trace Context Trust

**Symptom:** External requests showing up with attacker-controlled trace IDs in internal traces.

**Cause:** Inbound `traceparent` should only be trusted from ARC-authenticated callers (S-H13).

**Fix:** The Elysia plugin only extracts upstream trace context when the request presents `Authorization: ARC ...`. Anonymous/public requests start fresh root spans.

## Related

- [[observability/overview]] -- observability architecture overview
- [[observability/metrics]] -- metrics conventions and patterns
- [[observability/logging]] -- logging rules and redaction
