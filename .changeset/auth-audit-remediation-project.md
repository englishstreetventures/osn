---
---

Docs-only: add the **Auth Audit Remediation (2026-06)** project to `wiki/TODO.md`.

A cross-app authentication audit (OSN core, Pulse, Zap, Cire, and the shared
crypto/auth packages) surfaced one critical finding (Zap's hand-rolled HS256
shared-secret token verification) and one exploitable High (Cire's ~32-bit
single-factor claim code with per-isolate-only throttling), plus a batch of
hardening items. The findings are recorded as parallel workstreams W1–W7 with
`file:line` references, fixes, severities, and cross-links to the existing
Security Backlog IDs they fold into. No package code changed.
