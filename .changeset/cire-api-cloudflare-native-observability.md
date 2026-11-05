---
"@cire/api": patch
---

cire-api's Effect spans join its Cloudflare Workers trace: `fetch` and `scheduled` install `ctx.tracing` first, and `cireLoggerLayer` carries `WorkersTracingLive` in place of the OTLP exporter, so there is no per-request flush. Every cron sweep runs through `runCire`, so cron spans are mirrored and cron log lines take the redacting logger. The calls to osn-api and zap-api are plain `fetch` and carry no trace context.
