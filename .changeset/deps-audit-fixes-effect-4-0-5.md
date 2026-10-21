---
"@osn/api": patch
"@osn/client": patch
"@osn/db": patch
"@pulse/api": patch
"@pulse/db": patch
"@shared/crypto": patch
"@shared/db-utils": patch
"@shared/email": patch
"@shared/infra": patch
"@shared/observability": patch
"@shared/realtime": patch
"@shared/redis": patch
"@zap/api": patch
"@zap/db": patch
---

Dependency maintenance. The `effect` family moves from 4.0.3 to 4.0.5, a
patch release. Audit fixes take `fast-uri` to 3.1.8, `http-cache-semantics` to
4.3.0 and `smol-toml` to 1.9.0, and `valibot` is overridden to ^1.4.2 so the
`@prisma/dev` tree stops pinning 1.2.0. No runtime API changes are expected
from these bumps; the repo's typecheck and test suites pass, apart from three
`cire/host` component tests that also fail on the base branch.
