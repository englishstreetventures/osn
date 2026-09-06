---
"@cire/api": patch
---

Take @cloudflare/workers-types 5.20260830.1 (from 4.20260702.1), and update `tests/index.test.ts` to the tightened v5 shapes: `Span.setAttribute` now returns `this` with a required value, `Span` gained `setAttributes`, `Tracing` gained `startSpan`, and `ExecutionContext` gained the required members `exports` and `abort`. Test-only; no runtime change.
