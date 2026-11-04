---
"@shared/observability": patch
---

Inbound trace context becomes a span link, never the parent. Every server span the Elysia observability plugin starts is a new root with its own sampling decision, whatever headers the request carries, and a well-formed inbound `traceparent` is attached to it as a link holding the caller's trace id, span id and sampled bit. The unexported `getRequestContext` helper is removed: no package entry point exposed it.
