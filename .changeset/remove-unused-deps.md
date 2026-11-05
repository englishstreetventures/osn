---
"@musubi/landing": patch
"@musubi/social": patch
"@osn/auth-ui": patch
"@osn/db": patch
"@pulse/api": patch
"@pulse/db": patch
"@pulse/landing": patch
"@pulse/web": patch
"@shared/billing": patch
"@shared/infra": patch
"@shared/observability": patch
"@shared/sortable": patch
"@shared/toast": patch
"@shared/ui": patch
"@zap/db": patch
---

Drop dependencies no file imports (`motion`, `jose`, `@solidjs/meta`, `@solidjs/testing-library`, `@shared/design-tokens`, `@effect/vitest`, `@opentelemetry/exporter-logs-otlp-http`, and the direct `@vitest/browser` that `@vitest/browser-playwright` already brings in), and stop exporting shared symbols used only inside their own file. No behaviour changes.
